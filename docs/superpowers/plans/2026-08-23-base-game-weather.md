# Base Game weather — importing clouds and rain

Bringing the cloud deck (`clouds.js` as used by `environment-viewer-v2.html`, and the inline deck in
`demos/flight-sim.html`) and rain (`rain.js` as used by `bot-viewer-v3.html` and `demos/flight-sim.html`)
into `base-game.html`. Neither is new code to write from scratch; both are ports across three gaps the
donor pages do not have — a moving render origin, an authoritative day/night cycle, and multiplayer.

Roadmap note: weather is not one of the twelve steps in `docs/subsystems/base-game.md`. Steps 11 and 12
("world dressing", "remaining systems") are where it belongs; nothing else in the roadmap depends on it,
so it can land beside the water work rather than after it.

## What already exists (read from the code, not assumed)

### Clouds — two different implementations

`clouds.js` (271 lines) is `class Clouds extends THREE.Mesh`: a 2000 m quad, `MeshBasicNodeMaterial`,
`transparent`, `DoubleSide`, `depthWrite:false`, `fog:false`. Two octaves of simplex noise over
`positionWorld.xz / 1000` with a time offset, thresholded by `smoothstep(0.5±uSoftness, 0.5·n + uCoverage)`.
An extent-relative horizon fade (`haze` floored at 0.25, `edge` cutting the outer 15%) keeps the deck
reaching the horizon. Setters: `setSpeed/setOpacity/setCoverage/setPuff/setSoftness/setFade/setExtent`,
plus `update(elapsedSeconds, cameraPosition)`, which advances a self-accumulated clock (so a speed change
nudges the rate without a phase jump) and re-centres the fade on the camera. The colour is a hard-coded
`vec3(1,1,1)`; all shading lives in alpha.

`environment-viewer-v2.html:11479–11549` builds **two** independent `Clouds` layers (defaults: 120 m /
8 km extent, and 280 m / 16 km, puff 1.0 and 3.0), one panel header of sliders each, plus a shared
visibility and depth-write toggle. Per frame (`:15335–15342`) each layer's XZ is copied from the camera
and `update()` is called. `setCloudFar(layer, extent, height)` at `:8400` feeds `updateDrawDistance()`,
which grows `camera.far` to `hypot(extent/2, height)` so cloud corners are not clipped — and deliberately
does **not** grow `worldFog.far` with it.

`demos/flight-sim.html:853–872` does **not** use `clouds.js`. It is an inline 34 km plane at a fixed
`CLOUD_Y = 1400` — "a real altitude you can climb through and look down on, not a camera-locked dome" —
with 4-octave `mx_fractal_noise_float`, drift from `time`, a 9–15 km camera-distance fade, `renderOrder 5`,
and a colour that mixes white toward slate grey by `uOvercast`. `:4374` re-centres it on the camera each
frame. Its material is `irTagged` for `vision-modes.js`.

The two differ in intent: `clouds.js` is a low decorative deck seen from below; the flight-sim deck is a
fly-through altitude layer with larger-scale structure and a weather tint. Base Game wants both
properties.

### Rain — one module, two very different wirings

`rain.js` (411 lines): `createRainUniforms` (one shared uniform set so drops, splashes, wet ground and
lightning stay in lockstep), `createRainStreaks` / `createRainSplashes` (instanced camera-facing quads;
each drop's position is `hash(instanceIndex)` wrapped by `mod()` into a box that follows the camera, so
the field is endless and the only per-frame CPU work is advancing a fall accumulator and a wind
accumulator), `applyWetSurface` (puddle FBM, ripples, run-off streaks, wet normal — for any
`MeshStandardNodeMaterial`), `applyWetSheen` (the cheap version for props and bodies), `bakeOccluderMap`
(top-down height render of one layer so drops cut at roofs and splashes land on them),
`createLightningBolt`, `createRainBed` / `playThunder` (plain WebAudio), and `createRainSystem` tying it
together with `update(dt, camera)`, `setDensity/setWind/setGust/flash/setVisible`. Two page hooks:
`groundHeight(xzNode) -> heightNode` and `colorFn(rgbNode) -> rgbNode`. `rain-math.js` is the Node-tested
CPU twin of the maths (`test-rain-math.mjs`).

`bot-viewer-v3.html:829–930` is the full wiring: a `weather` object (`rain, lightning, occluders, puddles,
wind, lid, sightLoss`), `bakeRainOccluders()` over `mapRoot` + trees on a dedicated layer enabled for the
bake only, a `rainOccDirty` flag re-baked on the next rainy frame after any map or tree rebuild,
`applyWetSurface` on ground/walls/cover and `applyWetSheen` on bot materials, drops tinted 35% toward the
theme horizon, `weatherSightScale()` folding rain into `botSightDistanceFor` with a lightning reprieve,
a bolt timer (`5 + rand·14·(1.3 − rain)`), thunder delayed by `distance / 340`, and the rain bed on
`envAudio.playSynthLoop` so the mixer and mute apply. `visuals.setWeather({overcast, dim, fogBoost})`
greys the sky lid, dims the lights and thickens the fog from the same slider.

`demos/flight-sim.html:566–578, 4083–4108, 4417–4420` is the analytic wiring: no occluder map at all —
`groundHeight: (xz) => tslHeight(xz, tslSpacing(xz))` hands rain the terrain's own TSL height function, so
drops cut and splash rings land on the real ground with no bake. `colorFn` retints drops cold under IR.
One `setRain(v)` fans out to drop density, opacity, wetness, `uOvercast`, cloud cover, sun and hemi
intensity and `applyFog()`. Splashes are hidden above 160 m AGL.

## The gaps neither donor page has

**1. The render origin moves.** Both viewers keep the world at `(0,0,0)`. Base Game rebases
(`world-coordinates.js`, `base-game.html:1016`). Cloud noise is a function of `positionWorld.xz`, and
rain's puddles, ripples and drop hashes are functions of world position — so on a rebase the cloud
pattern and every puddle teleport. The fix already exists in this codebase: `base-game-water.js:187`
`applyOffset()` keeps a `uOffset` vec2 of the render origin and every world-space lookup adds it. Both new
modules take the same `worldCoordinates` argument and do the same thing.

**2. There is an authoritative day/night cycle.** `clouds.js` clouds are pure white and the flight-sim
deck is white-to-grey; both would glow at midnight. Base Game drives `rig.setSunColor(...)`,
`sunIntensity`, `moonIntensity` and `sky.nightness` every frame in `updateWorld()`
(`base-game.html:1259–1320`). Cloud colour must be a uniform the page writes from the same sun colour and
nightness, or the deck will not belong to the sky underneath it.

**3. Multiplayer.** Weather changes what players can see, so it is shared world state, not a local
toggle — the same argument that made the wave spectrum shared (`BASE_GAME_SHARED_KEYS`,
`base-game-protocol.mjs:38`). Lightning must strike the same place at the same moment on every client.

Two smaller ones:

**4. There is no scene fog.** `base-game.html` has none (the only `fog` hits are the underwater quad).
Overcast haze has to be introduced, and it interacts with the DOF post pipeline (`:527–530`).

**5. The terrain is streamed, not analytic**, so the flight-sim's `tslHeight` trick has no direct
equivalent — but `terrain-sea-depth.js:110` `gpuHeightAt(xz, fallback)` is exactly the same shape of
function: bilinear ground height at a global XZ from a toroidal clipmap window, 16 m posts over ~5 km,
already streaming whenever water is on (`base-game-water.js:186` calls `setSeaDepthActive(true)`
unconditionally). Rain gets its ground hook for free. Cost: 16 m posts, so on a cliff a splash ring can
sit a couple of metres off the real surface. Acceptable on rolling ground; state it rather than hide it.

## Decisions

- **Port `clouds.js`, do not port the flight-sim deck.** `clouds.js` is the shared, documented module
  with a real API and two consumers already. Take the two things the flight-sim version has that it
  lacks — fractal (multi-octave) noise for larger structure, and an overcast tint — as *options* on
  `clouds.js`, so `environment-viewer*.html` keeps its current look with the defaults unchanged.
- **Two decks, like env-viewer**, not one: a low deck and a high deck read as weather; one plane reads as
  a texture.
- **New page-level modules** `base-game-clouds.js` and `base-game-rain.js`, following `base-game-water.js`:
  they own the render-origin offset, the sun/nightness tint, the enable/disable rules and the profiler
  slot, and expose one `update(dt, camera)`. The page stays a wiring file.
- **Shared vs local settings.** Shared (owner-owned, replicated): `weatherRain`, `weatherWindDeg`,
  `weatherGust`, `cloudCover`, `cloudHeight`, `weatherSeed`. Local (quality/preference): drop budget,
  splashes on/off, wet ground on/off, occluder map on/off, cloud layer visibility, underwater rain
  suppression. This is the split the page already uses for water — spectrum shared, look local.
- **Lightning is derived, not sent.** A strike is `hash(weatherSeed, strikeIndex)` → time, bearing and
  distance; every client computes the same schedule from the shared seed and the room tick and looks up
  its own terrain height for the ground point. No new protocol messages, no bandwidth, and a late joiner
  is in phase.
- **Wet ground folds into the splat material, not `applyWetSurface`.** `terrain-splat-streamed.js:137`
  already takes an optional `water` bundle and branches inside the graph; wetness gets the same treatment
  as a `rain` bundle. Build it once (not on first rain) and branch on `wetness > 0` — a uniform branch is
  coherent across the draw, and rebuilding the splat instances mid-session is a visible hitch.
  `applyWetSurface` is still the right call for the Traversal Lab, whose materials are plain
  `MeshStandardNodeMaterial` (`base-game-traversal-lab.js:16`).

## Phases

Clouds first: it is the smaller port, it has no protocol or audio surface, and it gives rain the overcast
sky to fall out of.

### C1 — `base-game-clouds.js`: two decks that survive a rebase — SHIPPED 2026-08-24

- `clouds.js` gains three backward-compatible options (defaults reproduce today's look exactly):
  `octaves` (2 → the current two-tap simplex; higher uses `mx_fractal_noise_float`), `setOffset(x, z)`
  (a `uOffset` vec2 added to `positionWorld.xz` before the noise), and `setTint(color)` /
  `setOvercast(v)` replacing the hard-coded `vec3(1,1,1)`.
- `createBaseGameClouds({ scene, sky, rig, worldCoordinates })` builds the low and high decks, adds them
  to the scene, and exposes `setCover/setHeight/setOvercast/setEnabled/update(dt, camera, sunColor,
  nightness)`. `update` re-centres both decks on the camera, writes the origin offset, and tints:
  `mix(sunColor, grey, overcast)` scaled down by `nightness`, so a midnight deck is a dark silhouette
  against the stars rather than a white sheet.
- The page grows `camera.far` for the decks the way `updateDrawDistance()` does in env-viewer — except
  `base-game.html:1211` already computes `wantFar` from `terrain.farExtent` and rescales the sky with it,
  so cloud far becomes one more `Math.max` term in that existing line and `sky.setRadius(wantFar · 0.88)`
  keeps working.
- Panel: a **Weather** section (new, after Water) with layer height/extent/coverage/puff/softness/
  opacity/drift per deck, matching the env-viewer sliders. Every key goes in `DEFAULT_SETTINGS` — the
  page asserts that every registered control has a settings key, so save/load and slots come free.
- Profiler: fold into the existing `sky` slot (`base-game.html:2663`); two quads do not deserve their own.

Shipped as written, with three notes. The octave generalisation is `5·2ⁱ` frequency and `40/(1 + i/3)`
time divisor, which reproduces the original 5/40 and 10/30 pair exactly at two octaves, so the other
`clouds.js` consumers are untouched. The panel nesting needed three CSS additions to
`workshop-panel-theme.js` and two new helpers (`addColor`, `addAction`) in the page. Coverage is
`test-base-game-clouds.mjs` — 44 checks including a headless GLSL build at 1/2/4/6 octaves and a static
scan of `base-game.html` that mirrors the page's own control-registry assertion, so a weather setting
without a control fails in Node rather than at page load. Unseen in a browser.

### C2 — Overcast sky, dimmed light, haze — SHIPPED 2026-08-24

- `sky.js`: an `overcast` uniform on the dome, mixed in at the end of `skyColorAlong` toward a neutral
  grey, and the same mix applied where `applyDome` writes `scene.background`. Default 0, so
  `environment-viewer*.html` and every other consumer are unaffected. New setter `setOvercast(v)`.
- `updateWorld()` scales `sunIntensity` and `moonIntensity` by `1 − 0.72 · rain` (flight-sim's number) and
  lifts ambient slightly, so an overcast noon is flat rather than merely dark.
- Fog: an `exp2` fog attached at startup with density 0 and driven from there. Verified against the
  shipped r184 build rather than assumed: `FogExp2`'s colour and density become `reference()` nodes, so
  moving them at runtime is free, but `scene.fog` going from null to an object is pushed into the
  material cache key, so the first attach recompiles every material. `material.fog = false` does opt a
  material out (`setupOutput` gates on it), which is how the dome and the cloud decks stay clear of it.

**Correction to this plan's own claim.** It said fog would tint distant cloud into the horizon colour and
so hide the decks' rim. That is wrong for exp2 fog at these distances: `1 − exp(−(d·z)²)` at the lightest
density anyone would notice on the ground (0.0002, barely 2% at 500 m) is already 98% at deck A's 10 km
rim and total at deck B's 20 km. Scene fog would erase the decks, not soften them. What actually hides
the rim is the **overcast lid on the dome** — at full overcast the sky behind the clouds is the same grey
as the clouds, so the rim stops being a boundary between white and blue. The decks keep `fog: false`.

### C3 — Weather in the protocol — SHIPPED 2026-08-24

- `BASE_GAME_SHARED_KEYS` += `weatherRain, weatherWindDeg, weatherGust, cloudCover, cloudHeight,
  weatherSeed`; `NUMBER_LIMITS` entries for each (`weatherRain [0,1]`, `weatherWindDeg [0,360]`,
  `weatherGust [0,12]`, `cloudCover [0,0.95]`, `cloudHeight [40,4000]`, `weatherSeed [0,1e9]`, rounded
  like `waveSeed`); guests' controls disable through the existing `sharedSettingKeys` path.
- `server/base-game-rooms.js` carries them in the world state and echoes patches. The server does not
  simulate weather — nothing in the movement model reads it — so this is state carriage only. Say so in
  the doc, because "server-authoritative" elsewhere on this page means simulated.
- Tests: extend `server/test-base-game-rooms.mjs` for clamping and echo of the new keys.

### R1 — `base-game-rain.js`: drops that land on the real ground

- `createRainSystem({ maxDrops: 40000, maxSplashes: 5000, density: 0, uniforms: { wetness: 0 },
  groundHeight, colorFn })` where `groundHeight = (xz) => max(terrain.seaDepth.gpuHeightAt(xz.add(uOffset)),
  waterLevelNode)` — drops cut and splash on the terrain, and on the sea surface where the ground is below
  sea level, so rain over water reads correctly for free.
- Render-origin offset as in `base-game-water.js`; `update(dt, camera)` per frame in its own `weather`
  profiler slot next to `water`.
- Suppress splashes (not drops) while the camera is underwater — `water.underwater` is already computed
  each frame at `base-game.html:2657` — and hide the whole group when submerged.
- Traversal Lab mode: no terrain and no sea-depth window, so `groundHeight` falls back to the lab floor
  height (a constant) and the occluder map (R3) does the real work there.
- Wind comes from the shared `weatherWindDeg`; default it to the wave wind heading so sea and sky agree,
  but keep them independent settings.

#### R1b — Accuracy on cliffs

The 16 m sea-depth window is not a small error on steep ground: it is band-limited *at* 16 m, so a cliff
is not merely sampled coarsely, it is smoothed away. Meanwhile the exact chunks the player actually sees
are 30 m across with `round(30 × 0.75) = 23` segments — **about 1.3 m posts**. Rain sampling a 16 m
surface over a 1.3 m surface is a twelvefold mismatch, and on a bluff it puts the cut height tens of
metres from the drawn rock. Four things fix it, in order of value per unit of work:

1. **Bias low, never high — the error is asymmetric.** Both rain materials are `depthWrite:false` but
   leave `depthTest` at its default `true` (`rain.js:95, 179`), so a drop or a splash ring *below* the
   drawn ground is already hidden by the depth buffer. Only the over-estimate shows: rain cut off in mid
   air in front of a cliff face, and rings floating clear of the ground. So the sampled height must be
   conservative-low. Take `min` of the four surrounding posts instead of the bilinear blend when
   computing the cut and the ring placement — one `min` chain on values `gpuHeightAt` already fetches, no
   extra taps. `terrain-lod-coverage.js:28` `erode()` is the same trick (a 3×3 min so a coarse LOD never
   claims coverage a finer one has not filled), and is worth citing in the code so the two stay
   recognisable as one idea.

2. **A fine near-window for the ground hook.** Build a second `createSeaDepthMap`-style window at
   `post: 1.25`, `tileIntervals: 16` (20 m tiles), `tilesPerSide: 8` — 128 × 128 posts, a 160 m window,
   64 KB of float texture. That covers the drop volume (44 m) and the splash radius (16–26 m) with room
   over, at a spacing that matches what the exact chunks draw. Re-centring snaps by whole 20 m tiles, so
   a walking player triggers a row of ~8 tiles of 17 × 17 posts — negligible beside the terrain's own
   chunk stream. The two windows compose without a branch, because `gpuHeightAt` already takes a fallback
   node: `fine.gpuHeightAt(xz, coarse.gpuHeightAt(xz, float(-1000)))` — fine ground where the near window
   has streamed, the 16 m window beyond it, and drops that simply do not cut where neither has data yet.
   One caveat to check when writing it: `terrain-clipmap-window.js:72` requests `lod: level + 1`, so the
   finest a window can ask for is band-limited at its own spacing; the exact chunks request lod 0. At
   1.25 m posts the difference is sub-metre, but if it reads badly, `tileRequest` needs an option to ask
   for lod 0 rather than the window being pushed finer.

3. **Slope-aware splashes — the real visual bug on a cliff.** `rain.js:166` places every ring as a
   *horizontal* quad at `ground + 0.012`. On a 40° slope a horizontal ring is half buried and half
   floating no matter how accurate the height is, so precision alone cannot fix it. Take the gradient
   from the same neighbouring posts (two extra taps), then: fade rings out above roughly 35–40°, because
   rain runs off a rock face rather than beading on it, and orient the ones that remain to the surface
   normal. This is the single change that makes steep ground look right, and it makes the residual height
   error much harder to see, since the rings that would have been worst are the ones now suppressed.

4. **Accept that a heightfield cannot see an overhang.** Under a cave mouth or a ledge in volumetric
   terrain there is no "the" ground height, and the occluder map of R3 is a heightfield too, so it does
   not help. Rain keeps falling inside the overhang. The honest scope is: suppress rain when the player
   is under volumetric cover (a cheap upward probe through the existing world-query service), and leave
   the general case alone.

Items 1 and 3 are a few lines each inside `rain.js` and should land with R1. Item 2 is a new streamed
window and can follow as its own step once there is something on screen to judge it against.

### R2 — Wet ground and wet things

- `terrain-splat-streamed.js`: an optional `rain` bundle beside `water`, `{ wetness, puddle, ripple,
  offset }`, branching on `wetness > 0`; darkened albedo, roughness down, ripple normals, puddles in the
  flats. Reuse the maths from `applyWetSurface` rather than re-deriving it, and note in `rain.js` that a
  second copy now exists — the same hand-sync note the CPU/GPU twins carry.
- `applyWetSurface` on the Traversal Lab materials; `applyWetSheen` on player-body and weapon materials
  (bot-viewer already does exactly this for bot shells at `bot-viewer-v3.html:846`).
- Wet ground has to respect the wet tide band W6 already draws at the waterline: one is a tide line, the
  other is rain, and they should multiply rather than fight.

### R3 — Rain shadow where there are roofs

- Open terrain does not need an occluder map, and baking one every time the player walks costs an extra
  full-scene render per bake. So: **off by default in terrain mode**, on in the Traversal Lab (static,
  small, one bake at build, re-baked on a lab rebuild) and in volumetric/cave terrain.
- When on in terrain mode: a player-centred bake at 512², extent ~200 m, re-baked when the player leaves
  the middle half of the baked window or when chunk residency changes — the same `rainOccDirty` pattern as
  `bot-viewer-v3.html:869`, driven by the terrain's own residency signal rather than a timer.
- The bake renders the scene with an override material, so it must run outside the DOF pipeline and get
  its own `rainBake` profiler slot; folded into `weather` it would show up as rain costing 5 ms at random.

### R4 — Lightning, thunder, and the rain bed

- Deterministic schedule from `weatherSeed` and the room tick, as decided above; strikes only while
  `weatherRain > 0.3`, interval `4 + h·14·(1.3 − rain)` seconds where `h` is from the hash rather than
  `Math.random()`.
- `createLightningBolt(scene)` from the cloud base (the low deck's height) to `terrain.groundHeight(x, z)`
  0.8–4 km out; `rain.flash()` brightens the drops; the sun gets the same brief lift flight-sim gives it.
- Thunder at `distance / 340` through `envAudio.playSynthAt`, the rain bed through
  `envAudio.playSynthLoop` with `rainBed.set(level)`, both so the existing mixer, mute and the underwater
  low-pass (`environment-audio.js:2229`) apply. Solo pause must stop the bed; online pause must not —
  the page already distinguishes these.
- `base-game-audio.js` owns every other sound on this page, so the rain bed should be registered there
  rather than started from the page, keeping one owner for mute and volume.

### R5 — Panel, persistence, capture, docs, tests

- The full control list is its own section below — ten panel sections, about a hundred controls once the
  two cloud decks are counted separately.
- Settings ride `DEFAULT_SETTINGS`, so JSON export, the six slots and `applyAllState` cover them with no
  extra code, and shared keys disable for guests automatically.
- `research/stats/base-game-performance-log.json`: a capture with weather off, at rain 0.5, and at rain
  1.0 with lightning, so the cost is on record before it is tuned. `changedPerformanceSettings` needs the
  new keys listed or captures will silently compare unequal scenes.
- Docs: a Weather section in `docs/subsystems/base-game.md`; cross-links from `docs/subsystems/fx.md`
  (§Rain gains a third consumer) and `docs/subsystems/sky.md` (`clouds.js` gains options and an overcast
  uniform); an `agent_log.csv` row per phase.
- Tests (Node, no GPU): `test-base-game-weather.mjs` for the deterministic strike schedule (same seed and
  tick → same strike on two independent instances; a seed change moves it), the settings fan-out
  (`rain → density/overcast/fog` monotonic and clamped) and the render-origin offset arithmetic;
  `tsl-build-check.mjs` extended so the new cloud and splat-rain graphs build headless;
  `test-rain-math.mjs` unchanged.

## Controls

### How the master slider and the individual sliders coexist

Both donor pages fan one **rain** number out to a dozen effects, and that is the right top-level knob.
But a fan-out that *writes* the individual values fights anyone who then wants to tune one of them. So:
the master multiplies through a per-effect **response** slider — "fog per rain", "sun dimming per rain",
"cloud cover per rain" — which is strictly more control than either donor page has, and never moves a
value the user set by hand. Preset buttons (clear / overcast / storm) do fill everything, which is the
pattern `armPreset` already established in this page ("the preset dropdown fills the sliders; sliders
then override the preset individually", `base-game.html:1409`).

Two small panel helpers are missing and need writing: `addColor(host, key, label)` for the drop and fog
tints (stored as a hex string, so `assignLoadedSettings`'s string branch and `STRING_VALUES` cover it),
and `addAction(host, label, fn)` for the reroll and rebake buttons. Every slider key goes in
`DEFAULT_SETTINGS` or the page's control-registry assertion fails — which is the mechanism that keeps
all of this in the save slots and the JSON export for free.

Ranges below are deliberately wider than the useful band. Defaults are the useful band; the ends are
there to be dragged to.

### Weather (master) — collapsed: false

| Control | Key | Range | Default | Scope |
|---|---|---|---|---|
| Weather enabled | `weatherEnabled` | toggle | off | local |
| Rain | `weatherRain` | 0–1, 0.01 | 0 | **shared** |
| Wind heading | `weatherWindDeg` | 0–360, 1 | wave wind (38°) | **shared** |
| Wind speed | `weatherWindSpeed` | 0–60 m/s, 0.1 | 2.1 | **shared** |
| Gust amplitude | `weatherGust` | 0–40 m/s, 0.1 | 3.0 | **shared** |
| Gust period | `weatherGustPeriod` | 0.5–60 s, 0.1 | 17 | **shared** |
| Link wind to the wave heading | `weatherWindFollowsWaves` | toggle | on | local |
| Weather seed | `weatherSeed` | 0–1e9, 1 | 7 | **shared** |
| Reroll seed | (action) | — | — | — |
| Preset | (actions) | clear / overcast / storm | — | — |

`weatherWindSpeed` + `weatherWindDeg` replace `rain.js`'s raw `windX`/`windZ`; the module converts.
The gust period is new — `createRainSystem` hard-codes `0.37` and `0.23` rad/s wander (`rain.js:390`),
and a storm wants slower, larger gusts than a drizzle.

### Clouds — deck A / deck B (two identical sections)

| Control | Key | Range | Default A | Default B |
|---|---|---|---|---|
| Deck visible | `cloudAVisible` | toggle | on | on |
| Height | `cloudAHeight` | 0–10000 m, 1 | 900 | 2200 |
| Extent | `cloudAExtent` | 200–60000 m, 10 | 20000 | 40000 |
| Coverage | `cloudACover` | 0–1, 0.01 | 0.42 | 0.30 |
| Puff size | `cloudAPuff` | 0.05–12, 0.01 | 1.6 | 4.0 |
| Softness | `cloudASoftness` | 0.005–1, 0.005 | 0.30 | 0.30 |
| Opacity | `cloudAOpacity` | 0–1, 0.01 | 0.88 | 0.50 |
| Horizon fade | `cloudAFade` | 0–2, 0.02 | 0.5 | 0.5 |
| Drift speed | `cloudASpeed` | −8 to 8, 0.01 | 1.0 | 0.6 |
| Noise octaves | `cloudAOctaves` | 1–6, 1 | 4 | 3 |
| Cover per rain | `cloudACoverPerRain` | −1 to 1, 0.01 | 0.35 | 0.20 |

The heights and extents are **not** the env-viewer defaults (120 m / 280 m over an 8 km extent). Those
suit a small sandbox; Base Game draws terrain to kilometres, so the decks start where flight-sim put
theirs — an altitude you could fly through — and the extents follow. Negative drift speed is allowed
because it costs nothing and someone will want the deck to run the other way.

### Clouds — shared across both decks

| Control | Key | Range | Default |
|---|---|---|---|
| Clouds enabled | `cloudsEnabled` | toggle | on |
| Depth write | `cloudDepthWrite` | toggle | off |
| Tint follows the sun | `cloudTintFollowsSun` | toggle | on |
| Manual tint | `cloudTint` | colour | `#ffffff` |
| Night darkening | `cloudNightDim` | 0–1, 0.01 | 0.85 |
| Overcast grey | `cloudOvercastTint` | 0–1, 0.01 | 0.55 |
| Copy deck A to deck B | (action) | — | — |

### Rain — drops

| Control | Key | Range | Default |
|---|---|---|---|
| Drops visible | `rainDropsEnabled` | toggle | on |
| Max drops (allocation) | `rainMaxDrops` | 1000–200000, 1000 | 40000 |
| Density per rain | `rainDensityPerRain` | 0–2, 0.01 | 0.9 |
| Density floor | `rainDensityBase` | 0–1, 0.01 | 0 |
| Fall speed | `rainSpeed` | 0–120 m/s, 0.5 | 18 |
| Streak length | `rainLength` | 0–12 m, 0.01 | 1.1 |
| Streak width | `rainWidth` | 0.001–0.4 m, 0.001 | 0.014 |
| Opacity floor | `rainOpacityBase` | 0–1, 0.01 | 0.45 |
| Opacity per rain | `rainOpacityPerRain` | 0–1, 0.01 | 0.25 |
| Drop colour | `rainColor` | colour | `#b8bcc4` |
| Tint toward the sky horizon | `rainSkyTint` | 0–1, 0.01 | 0.35 |
| Volume width | `rainVolumeXZ` | 4–400 m, 1 | 44 |
| Volume height | `rainVolumeY` | 4–400 m, 1 | 36 |
| Near fade start | `rainNearStart` | 0–5 m, 0.01 | 0.25 |
| Near fade end | `rainNearEnd` | 0–10 m, 0.01 | 1.4 |
| Lean into camera motion | `rainCamLean` | 0–3, 0.01 | 1.0 |

Max drops reallocates the instanced geometry, so it is a rebuild, not a uniform — cheap (one geometry)
but worth a note in the label. The near fade is currently a hard-coded `smoothstep(0.25, 1.4, …)`
(`rain.js:123`) that stops streaks smearing across the lens; it is exactly the sort of number someone
will want to argue with in first person.

### Rain — splashes

| Control | Key | Range | Default |
|---|---|---|---|
| Splashes | `rainSplashEnabled` | toggle | on |
| Max splashes (allocation) | `rainMaxSplashes` | 200–40000, 100 | 5000 |
| Radius | `rainSplashRadius` | 2–160 m, 1 | 20 |
| Ring size | `rainSplashSize` | 0.01–3 m, 0.01 | 0.22 |
| Ring rate | `rainSplashRate` | 0.1–12 /s, 0.1 | 1.6 |
| Suppress on slopes above | `rainSplashSlopeMax` | 0–90°, 1 | 38 |
| Slope fade width | `rainSplashSlopeFade` | 0–45°, 1 | 12 |
| Orient rings to the surface | `rainSplashOrient` | toggle | on |
| Hide above this height AGL | `rainSplashMaxAgl` | 0–2000 m, 5 | 160 |

The last one is flight-sim's rule (`:4353`); a ground-bound player never hits it, but the drone and
flight work in the other plans will.

### Rain — wet surfaces

| Control | Key | Range | Default |
|---|---|---|---|
| Wet surfaces | `rainWetEnabled` | toggle | on |
| Wetness per rain | `rainWetnessPerRain` | 0–2, 0.01 | 1.4 |
| Dry-out time | `rainDryTime` | 0–600 s, 1 | 90 |
| Puddle coverage | `rainPuddle` | 0–1, 0.01 | 0.45 |
| Puddle scale | `rainPuddleScale` | 0.005–1, 0.005 | 0.09 |
| Ripple strength | `rainRipple` | 0–4, 0.01 | 1.0 |
| Ripple scale | `rainRippleScale` | 0.1–20, 0.1 | 3.0 |
| Run-off streaks on walls | `rainStreaksOnWalls` | toggle | on |
| Wet sheen on bodies and weapons | `rainWetSheen` | toggle | on |
| Sheen amount | `rainSheenAmount` | 0–1, 0.01 | 0.55 |
| Sheen darkening | `rainSheenDarken` | 0–1, 0.01 | 0.1 |

Dry-out time is new and neither donor has it: today wetness tracks rain instantly, so ground goes bone
dry the frame a storm stops. A first-order lag on the wetness uniform is three lines and fixes it.

### Rain — ground accuracy (R1b)

| Control | Key | Range | Default |
|---|---|---|---|
| Ground source | `rainGroundSource` | `fine` / `coarse` / `off` | `fine` |
| Near-window spacing | `rainFineSpacing` | 0.25–16 m, 0.25 | 1.25 |
| Near-window extent | `rainFineExtent` | 32–1280 m, 16 | 160 |
| Conservative (min) sampling | `rainGroundConservative` | toggle | on |
| Rain shadow | `rainShadowMode` | `off` / `labAndCaves` / `always` | `labAndCaves` |
| Occluder resolution | `rainOccluderSize` | 128–2048, 128 | 512 |
| Occluder extent | `rainOccluderExtent` | 32–1024 m, 8 | 200 |
| Auto-rebake on scene change | `rainOccluderAuto` | toggle | on |
| Rebake now | (action) | — | — |

These are diagnostic as much as aesthetic: the whole point of R1b is that the right numbers are not
known until someone stands on a cliff in the rain and drags them.

### Lightning

| Control | Key | Range | Default |
|---|---|---|---|
| Lightning | `lightningEnabled` | toggle | on |
| Rain threshold | `lightningThreshold` | 0–1, 0.01 | 0.3 |
| Mean interval | `lightningInterval` | 0.5–300 s, 0.5 | 9 |
| Interval spread | `lightningIntervalSpread` | 0–1, 0.01 | 0.7 |
| Nearest strike | `lightningDistMin` | 20–20000 m, 10 | 800 |
| Farthest strike | `lightningDistMax` | 50–40000 m, 50 | 4000 |
| Flash strength | `lightningFlash` | 0–8, 0.05 | 1.0 |
| Flash decay | `lightningDecay` | 0.2–20, 0.1 | 3.5 |
| Bolt thickness | `lightningBoltScale` | 0.1–8, 0.05 | 1.0 |
| Sun lift on a flash | `lightningSunLift` | 0–10, 0.1 | 4.0 |
| Strike now | (action) | — | — |

`lightningThreshold`, `lightningInterval` and the distances feed the deterministic schedule, so they are
**shared** — two clients with different intervals would see different storms.

### Atmosphere response

| Control | Key | Range | Default |
|---|---|---|---|
| Overcast (manual) | `weatherOvercast` | 0–1, 0.01 | 0 |
| Overcast per rain | `overcastPerRain` | 0–2, 0.01 | 1.25 |
| Sun dimming per rain | `sunDimPerRain` | 0–1, 0.01 | 0.72 |
| Ambient lift per rain | `ambientLiftPerRain` | 0–1, 0.01 | 0.15 |
| Rain fog | `weatherFogEnabled` | toggle | on |
| Fog density (clear) | `weatherFogBase` | 0–0.02, 0.0001 | 0 |
| Fog density per rain | `weatherFogPerRain` | 0–0.05, 0.0001 | 0.004 |
| Fog colour source | `weatherFogSource` | `domeHorizon` / `custom` | `domeHorizon` |
| Fog colour | `weatherFogColor` | colour | `#8a929c` |
| Suppress rain underwater | `rainUnderwaterOff` | toggle | on |

### Weather audio

| Control | Key | Range | Default |
|---|---|---|---|
| Rain bed | `weatherRainBed` | toggle | on |
| Rain bed volume | `weatherRainBedVolume` | 0–1, 0.01 | 0.7 |
| Thunder | `weatherThunder` | toggle | on |
| Thunder volume | `weatherThunderVolume` | 0–1, 0.01 | 0.9 |
| Speed of sound | `weatherSoundSpeed` | 50–2000 m/s, 5 | 340 |

Speed of sound is in here because the delay between flash and clap is the whole effect, and dragging it
is the fastest way to hear whether the delay is wired to distance at all.

### What is shared, in one place

`weatherRain`, `weatherWindDeg`, `weatherWindSpeed`, `weatherGust`, `weatherGustPeriod`, `weatherSeed`,
`cloudACover`, `cloudAHeight`, `cloudBCover`, `cloudBHeight`, `lightningEnabled`,
`lightningThreshold`, `lightningInterval`, `lightningIntervalSpread`, `lightningDistMin`,
`lightningDistMax`. Everything else is local look and quality, so two players on one server can run
40,000 drops and 2,000 drops in the same storm.

That is sixteen new shared keys against eleven for water, which is worth a look at
`sanitizeBaseGameWorldPatch`'s cost per patch before it ships — the sanitizer walks every shared key on
every patch, and a slider drag queues one patch per input event.

## Order

C1 → C2 → C3, then R1 → R2 → R4 → R5, with R3 parallel to R2 (it touches nothing R2 touches) and C3
parallel to R1 (protocol carriage is independent of rendering). R5 closes both halves.

The clouds half is worth shipping on its own: a two-deck sky that tints with the sun is a visible
improvement with no gameplay, protocol or audio surface, and it is what makes rain look like it comes
from somewhere.

## Known limits to state, not hide

- With R1b's fine window, splash rings and drop cuts are accurate to roughly the spacing the exact chunks
  are drawn at. Without it — if only the conservative-low sampling and slope fade ship — rain on a bluff
  cuts low rather than high, so it errs toward drops continuing into rock that the depth buffer hides,
  not toward a hole in the rain. Boulders and anything smaller than a post are invisible to either
  window either way.
- The sea-depth window is only streamed while water is enabled. Rain in a world with water turned off
  would have no ground hook, so rain must force `setSeaDepthActive(true)` as well — and the streaming
  cost then belongs to whichever system asked for it.
- The occluder map is a height texture, so it cannot represent a floor above open air. Rain under a bridge
  stops correctly, but so does rain on the open ground beside a deck that overhangs it. This is inherited
  from `rain.js` and is not worth fixing for a first pass.
- Drops are transparent and write no depth, so the DOF pass computes their circle of confusion from the
  opaque surface behind them: a drop 30 cm from the eye can be blurred as if it were at the ground's
  distance. Check this in the browser at a wide aperture before tuning anything else; if it is bad, the
  fix is to render rain after the pipeline rather than to fight the CoC.
- Weather is carried by the server but not simulated by it. Two clients see the same weather because they
  share the seed and the settings, not because anyone is authoritative over a drop.
- Nothing here reads weather as gameplay. Bot-viewer shrinks sight distance in rain; Base Game has no AI
  to blind, and shrinking a *player's* effective sight is a design decision, not a port.
